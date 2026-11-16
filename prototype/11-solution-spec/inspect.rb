#!/usr/bin/env ruby
# PROTOTYPE — throwaway inspection harness, not a test suite.
# Run from the repo root: ruby prototype/11-solution-spec/inspect.rb
require "date"
require "json"
require "open3"
require "pathname"
require "yaml"

ROOT = Pathname.new(__dir__)
SPEC_DIR = ROOT.join("acme/solutions/claims-triage")
SPEC_PATH = SPEC_DIR.join("solution.yaml")
LOCK_PATH = SPEC_DIR.join("solution.lock")
ENV_PATH = ROOT.join("acme/environments/acme-prod.yaml")
CCP_DIR = ROOT.join("acme/customer/context-packages/acme-claims-context")
MODEL_PROFILE_DIR = ROOT.join("model-profiles")
GEN = ROOT.join("generated/claims-triage")
DEPLOY = GEN.join("deploy")

@ok = []
@warnings = []
@errors = []

def yaml(path)
  YAML.safe_load(path.read, aliases: true, permitted_classes: [Date, Time])
rescue StandardError => e
  @errors << "cannot parse #{path.relative_path_from(ROOT)}: #{e.message}"
  nil
end

def expect(condition, message)
  condition ? @ok << message : @errors << message
  condition
end

def warn(message)
  @warnings << message
end

def rel(path)
  path.relative_path_from(ROOT).to_s
end

def policy_ref(entry)
  ref = entry.is_a?(Hash) ? entry["ref"] : entry
  ref.to_s
end

def policy_applies_to?(entry, tool_name)
  applies = entry.is_a?(Hash) ? entry["appliesTo"] : nil
  applies.nil? || Array(applies).include?(tool_name)
end

spec = yaml(SPEC_PATH)
lock = yaml(LOCK_PATH)
environment = yaml(ENV_PATH)
exit(1) unless spec && lock && environment

puts "== Spec and lock =="
expect(spec.dig("metadata", "customer") == "acme", "spec customer is acme")
expect(spec.dig("metadata", "solution") == "claims-triage", "spec solution is claims-triage")
expect(spec.dig("apiVersion") == "fde.dev/v0", "spec apiVersion is fde.dev/v0")
expect(lock["lockVersion"] == 1, "lock version is 1")

capability_template_names = (lock.dig("templates", "capability") || {}).keys
policy_names = (lock.dig("templates", "policy") || {}).keys +
               (lock.dig("assets", "policies") || {}).keys
eval_names = (lock.dig("templates", "eval") || {}).keys +
             (lock.dig("assets", "evalSuites") || {}).keys
overlay_names = (lock["overlays"] || {}).keys
extension_names = (lock["extensions"] || {}).keys
model_profile_names = (lock["modelProfiles"] || {}).keys
lock_files = lock.dig("spec", "files") || {}
expect(lock_files.key?("solution.yaml"), "lock spec.files includes solution.yaml")
capabilities = spec.dig("spec", "capabilities") || {}
agents = spec.dig("spec", "agents") || {}
workflows = spec.dig("spec", "workflows") || {}
tools = spec.dig("spec", "tools") || {}
policy_templates = {}
Dir.glob(ROOT.join("acme/policies/*.yaml")).each do |path|
  document = yaml(Pathname.new(path))
  policy_templates[document.dig("metadata", "name")] = document if document
end

capabilities.each do |name, capability|
  template = capability["template"].to_s.split("@").first
  expect(capability_template_names.include?(template), "capability #{name} template #{template} is pinned")
  impl = capability["implementation"] || {}
  if impl["type"] == "agent"
    expect(agents.key?(impl["ref"]), "capability #{name} agent #{impl["ref"]} exists")
  elsif impl["type"] == "workflow"
    expect(workflows.key?(impl["ref"]), "capability #{name} workflow #{impl["ref"]} exists")
  else
    expect(false, "capability #{name} has a known implementation type")
  end
  (capability["policyRefs"] || []).each do |entry|
    ref = policy_ref(entry)
    expect(policy_names.include?(ref.split("@").first), "capability #{name} policy #{ref} is pinned")
  end
  (capability["evalRefs"] || []).each do |ref|
    expect(eval_names.include?(ref.split("@").first), "capability #{name} eval #{ref} is pinned")
  end
end

agents.each do |name, agent|
  (agent["tools"] || []).each do |tool|
    expect(tools.key?(tool), "agent #{name} tool #{tool} exists")
  end
  if agent["modelProfile"]
    profile_ref = agent["modelProfile"].to_s
    profile_name = profile_ref.split("@").first
    expect(model_profile_names.include?(profile_name),
           "agent #{name} modelProfile #{profile_ref} is pinned")
    profile_version = (lock["modelProfiles"] || {})[profile_name].to_s.split("@").first
    profile_doc = yaml(MODEL_PROFILE_DIR.join("#{profile_name}.yaml"))
    expect(!profile_doc.nil?, "model profile #{profile_name} artifact is readable")
    if profile_doc
      expect(profile_doc.dig("metadata", "version") == profile_version,
             "model profile #{profile_name} version matches lock")
      expect(profile_doc.dig("spec", "modelVersion") != "latest",
             "model profile #{profile_name} modelVersion is pinned")
      (profile_doc.dig("spec", "fallback") || []).each do |fallback|
        fallback_name = fallback["profile"].to_s.split("@").first
        expect(model_profile_names.include?(fallback_name),
               "model profile #{profile_name} fallback #{fallback_name} is pinned")
      end
    end
  end
  instructions = agent["instructions"]
  if instructions
    expect(SPEC_DIR.join(instructions).file?, "agent #{name} instructions #{instructions} exist")
    expect(lock_files.key?(instructions), "agent #{name} instructions #{instructions} is in lock spec.files")
  end
end

PLATFORM_ROLES = %w[end_user approver customer_admin deployment_operator auditor service support].freeze
CLASSIFICATION_RANK = %w[public internal confidential restricted].freeze
RETENTION_RANK = %w[ephemeral standard extended legal_hold].freeze

def schema_at(schema, path)
  cursor = schema
  path.to_s.split(".").each do |segment|
    next if segment == "output"

    return nil unless cursor.is_a?(Hash)

    cursor = cursor.dig("properties", segment)
  end
  cursor
end

def step_index(steps, id)
  steps.index { |step| step["id"] == id }
end

workflow_recipes = spec.dig("spec", "semantic", "recipeBindings") || {}

puts "== Decision audit binding (#20) =="
capabilities.each do |cap_name, capability|
  impl = capability["implementation"] || {}
  side_effecting_tools =
    case impl["type"]
    when "workflow"
      steps = (workflows[impl["ref"]] || {})["steps"] || []
      steps.select { |step| step["type"] == "tool" }
           .map { |step| step["tool"] }
           .uniq
           .select { |tool_name| tools.dig(tool_name, "sideEffects") && tools.dig(tool_name, "sideEffects") != "read" }
    when "agent"
      (agents.dig(impl["ref"], "tools") || []).select do |tool_name|
        tools.dig(tool_name, "sideEffects") && tools.dig(tool_name, "sideEffects") != "read"
      end
    else
      []
    end

  audit = capability["audit"] || {}
  evidence_map = audit["evidence"] || {}
  run_outcome = audit["runOutcomeDecision"] || "required"
  expect(%w[required omitted].include?(run_outcome),
         "capability #{cap_name} runOutcomeDecision is valid")
  expect(!(run_outcome == "omitted" && side_effecting_tools.any?),
         "capability #{cap_name} may omit run outcome only when read-only")

  side_effecting_tools.each do |tool_name|
    tool_audit = tools.dig(tool_name, "audit") || {}
    expect(CLASSIFICATION_RANK.include?(tool_audit["classification"]),
           "tool #{tool_name} declares a valid classification")
    expect(RETENTION_RANK.include?(tool_audit["retentionClass"]),
           "tool #{tool_name} declares a valid retention class")

    selectors = evidence_map[tool_name]
    expect(selectors.is_a?(Array) && selectors.any?,
           "capability #{cap_name} declares evidence for side-effecting tool #{tool_name}")

    covering = (capability["policyRefs"] || []).select do |entry|
      template = policy_templates[policy_ref(entry).split("@").first]
      template && template.dig("spec", "enforcementPoint") == "tool.pre_invoke" &&
        policy_applies_to?(entry, tool_name)
    end
    expect(covering.any?,
           "capability #{cap_name} has tool.pre_invoke coverage for #{tool_name}")

    next unless selectors.is_a?(Array)

    steps = impl["type"] == "workflow" ? (workflows[impl["ref"]] || {})["steps"] || [] : []
    tool_step_index = steps.index { |step| step["type"] == "tool" && step["tool"] == tool_name }
    selectors.each do |selector|
      from = selector["from"]
      expect(%w[retrieval input step].include?(from),
             "capability #{cap_name} evidence #{tool_name} has a known selector")
      if from == "retrieval" && selector["recipe"]
        expect(workflow_recipes.key?(selector["recipe"]),
               "capability #{cap_name} evidence #{tool_name} recipe #{selector['recipe']} is bound")
      end
      next unless from == "step"

      source_index = step_index(steps, selector["step"])
      expect(source_index && (tool_step_index.nil? || source_index < tool_step_index),
             "capability #{cap_name} evidence #{tool_name} step #{selector['step']} is upstream")
      expect(%w[artifact citations].include?(selector["as"] || "artifact"),
             "capability #{cap_name} evidence #{tool_name} has a valid as mode")
      source_step = source_index ? steps[source_index] : nil
      expect(source_step && source_step["outputSchema"],
             "capability #{cap_name} evidence #{tool_name} source declares outputSchema")
      if source_step && source_step["outputSchema"]
        schema = yaml(SPEC_DIR.join(source_step["outputSchema"]))
        expect(!schema_at(schema, selector["path"]).nil?,
               "capability #{cap_name} evidence #{tool_name} path exists in step output schema")
      end
    end
  end
end

workflows.each do |name, workflow|
  steps = workflow["steps"] || []
  _capability_name, capability = capabilities.find do |_, candidate|
    candidate.dig("implementation", "ref") == name
  end
  bound_policies = (capability&.dig("policyRefs") || []).map { |entry| policy_ref(entry).split("@").first }

  steps.each_with_index do |step, index|
    case step["type"]
    when "agent"
      expect(agents.key?(step["agent"]), "workflow #{name} step #{step["id"]} agent #{step["agent"]} exists")
      if step["outputSchema"]
        expect(SPEC_DIR.join(step["outputSchema"]).file?,
               "workflow #{name} step #{step["id"]} outputSchema exists")
        expect(lock_files.key?(step["outputSchema"]),
               "workflow #{name} step #{step["id"]} outputSchema is in lock spec.files")
      end
    when "tool"
      expect(tools.key?(step["tool"]), "workflow #{name} step #{step["id"]} tool #{step["tool"]} exists")
    when "context"
      expect(workflow_recipes.key?(step["recipe"]), "workflow #{name} step #{step["id"]} recipe #{step["recipe"]} is bound")
    when "approval"
      expect(workflow["durable"] == true, "workflow #{name} is durable for approval step #{step["id"]}")
      expect(step["gates"].is_a?(String), "workflow #{name} step #{step["id"]} declares a gated step")
      gate = steps[index + 1]
      expect(gate && gate["id"] == step["gates"],
             "workflow #{name} step #{step["id"]} gates the next step")
      if gate
        expect(gate["type"] == "tool", "workflow #{name} step #{step["id"]} gates a tool step")
        gated_tool = tools[gate["tool"]] || {}
        expect(gated_tool["sideEffects"] && gated_tool["sideEffects"] != "read",
               "workflow #{name} step #{step["id"]} gates a side-effecting tool")
      end
      roles = step["approverRoles"] || []
      expect(roles.any?, "workflow #{name} step #{step["id"]} declares approver roles")
      expect(roles.uniq.size == roles.size, "workflow #{name} step #{step["id"]} approver roles are unique")
      expect((roles & PLATFORM_ROLES).empty?,
             "workflow #{name} step #{step["id"]} uses business roles only")
      expires = step["expiresAfter"].to_s
      expect(expires.match?(/\APT(?:\d+H)?(?:\d+M)?(?:\d+S)?\z/) && expires != "PT",
             "workflow #{name} step #{step["id"]} expiresAfter is an ISO-8601 duration")
      predicate_ref = step.dig("requiredWhen", "predicate")
      if predicate_ref
        expect(policy_names.include?(predicate_ref.split("@").first),
               "workflow #{name} step #{step["id"]} predicate #{predicate_ref} is pinned")
        expect(bound_policies.include?(predicate_ref.split("@").first),
               "workflow #{name} step #{step["id"]} predicate is bound to the capability")
        (step.dig("requiredWhen", "args") || {}).each do |arg, ref|
          next unless ref.is_a?(Hash) && ref["step"]

          source_index = step_index(steps, ref["step"])
          expect(source_index && source_index < index,
                 "workflow #{name} step #{step["id"]} arg #{arg} references an upstream step")
          source_step = source_index ? steps[source_index] : nil
          expect(source_step && source_step["outputSchema"],
                 "workflow #{name} step #{step["id"]} arg #{arg} source declares outputSchema")
          if source_step && source_step["outputSchema"]
            schema = yaml(SPEC_DIR.join(source_step["outputSchema"]))
            expect(!schema_at(schema, ref["path"]).nil?,
                   "workflow #{name} step #{step["id"]} arg #{arg} path exists in the output schema")
          end
        end
      end
      evidence_sources = step["evidenceFrom"] || []
      expect(evidence_sources.any?, "workflow #{name} step #{step["id"]} declares evidence sources")
      evidence_sources.each do |source|
        source_index = step_index(steps, source)
        expect(source_index && source_index < index,
               "workflow #{name} step #{step["id"]} evidence #{source} is upstream")
        expect(source_index && %w[context tool].include?(steps[source_index]["type"]),
               "workflow #{name} step #{step["id"]} evidence #{source} is context/tool")
      end
      summary = step["summaryFrom"]
      if summary
        source_index = step_index(steps, summary["step"])
        expect(source_index && source_index < index,
               "workflow #{name} step #{step["id"]} summary references an upstream step")
        source_step = source_index ? steps[source_index] : nil
        expect(source_step && source_step["outputSchema"],
               "workflow #{name} step #{step["id"]} summary source declares outputSchema")
        if source_step && source_step["outputSchema"]
          schema = yaml(SPEC_DIR.join(source_step["outputSchema"]))
          field = schema_at(schema, summary["path"])
          expect(field && field["type"] == "string",
                 "workflow #{name} step #{step["id"]} summary path resolves to a string")
        end
      end
    else
      expect(false, "workflow #{name} step #{step["id"]} has a known type")
    end
  end
end

policy_path = ROOT.join("acme/policies/claims-approval-threshold.yaml")
policy = yaml(policy_path)
expect(!policy.nil?, "claims-approval-threshold policy template is readable")
if policy
  expect(policy.dig("metadata", "version") == "1.0.0",
         "claims-approval-threshold version is 1.0.0")
  amount_parameter = policy.dig("spec", "parameters", "amount") || {}
  expect(amount_parameter["type"] == "number",
         "claims-approval-threshold amount parameter is numeric")
  expect(amount_parameter["direction"] == "lower_is_stricter",
         "claims-approval-threshold tightens downward")
  expect(policy.dig("spec", "predicate", "kind") == "threshold",
         "claims-approval-threshold predicate kind is threshold")
  expect(policy.dig("spec", "predicate", "parameter") == "amount",
         "claims-approval-threshold predicate reads the amount parameter")
end

tool_policy = policy_templates["tool-allowlist"]
expect(!tool_policy.nil?, "tool-allowlist policy template is readable")
if tool_policy
  expect(tool_policy.dig("spec", "enforcementPoint") == "tool.pre_invoke",
         "tool-allowlist enforcement point is tool.pre_invoke")
  allow_parameter = tool_policy.dig("spec", "parameters", "allow") || {}
  expect(allow_parameter["type"] == "array",
         "tool-allowlist allow parameter is an array")
end

connector_dir = ROOT.join("acme/customer/connectors")
connectors = Dir.glob(connector_dir.join("*.yaml")).to_h do |path|
  document = yaml(Pathname.new(path))
  [document.dig("metadata", "name"), document]
end

tools.each do |name, tool|
  if tool["connectorRef"]
    connector = connectors[tool["connectorRef"]]
    expect(!connector.nil?, "tool #{name} connector #{tool["connectorRef"]} exists")
    if connector
      operations = connector.dig("spec", "allowedOperations") || []
      expect(operations.include?(tool["operation"]), "tool #{name} operation #{tool["operation"]} is allowed by connector")
    end
  elsif tool["builtin"]
    warn("GAP: tool #{name} uses `builtin`, which is not a documented Tool field")
  else
    warn("GAP: tool #{name} has no documented implementation discriminator (connectorRef, builtin, or extensionRef)")
  end
  if tool["sideEffects"] && tool["sideEffects"] != "read"
    audit = tool["audit"] || {}
    expect(CLASSIFICATION_RANK.include?(audit["classification"]),
           "tool #{name} declares a valid classification")
    expect(RETENTION_RANK.include?(audit["retentionClass"]),
           "tool #{name} declares a valid retention class")
  end
  %w[inputSchema outputSchema].each do |field|
    next unless tool[field]

    expect(SPEC_DIR.join(tool[field]).file?, "tool #{name} #{field} exists")
    expect(lock_files.key?(tool[field]), "tool #{name} #{field} #{tool[field]} is in lock spec.files")
  end
end

(spec.dig("spec", "governance", "evalSuites") || []).each do |ref|
  expect(eval_names.include?(ref.split("@").first), "governance eval #{ref} is pinned")
end
(spec.dig("spec", "overlays") || []).each do |ref|
  expect(overlay_names.include?(ref.split("@").first), "overlay #{ref} is pinned")
end
(spec.dig("spec", "extensions") || []).each do |ref|
  expect(extension_names.include?(ref.split("@").first), "extension #{ref} is pinned")
end

ccp_manifest = yaml(CCP_DIR.join("manifest.yaml"))
expect(!ccp_manifest.nil?, "customer context package manifest is readable through the symlink")
if ccp_manifest
  expect(ccp_manifest.dig("metadata", "version") == "1.0.0", "CCP version is 1.0.0")
  (spec.dig("spec", "semantic", "recipeBindings") || {}).each do |name, binding|
    recipe_name, recipe_version = binding["recipeRef"].to_s.split("@")
    recipe = yaml(CCP_DIR.join("recipes/#{recipe_name}.yaml"))
    expect(!recipe.nil?, "recipe binding #{name} resolves #{recipe_name}")
    if recipe && recipe_version
      expect(recipe_version == "^#{recipe.dig("metadata", "version")}" || recipe_version == recipe.dig("metadata", "version"),
             "recipe binding #{name} version matches CCP")
    end
  end
end

puts "== Evaluation =="
eval_suite = yaml(GEN.join("eval/suites/claims-triage-quality.yaml"))
metric_catalog = yaml(GEN.join("eval/metric-catalog.yaml"))
dataset = yaml(ROOT.join("acme/eval/claims-triage-quality/dataset.manifest.yaml"))
if eval_suite && metric_catalog && dataset
  expect(eval_suite.dig("spec", "capabilityRef") == "document-triage@1.0.0", "L2 suite targets document-triage")
  expect(eval_suite.dig("spec", "metricCatalogRef") == "#{metric_catalog.dig("metadata", "name")}@#{metric_catalog.dig("metadata", "version")}",
         "L2 suite metric catalog ref matches catalog")
  dataset_ref = eval_suite.dig("spec", "datasetRef") || {}
  expect(dataset_ref["id"] == dataset.dig("metadata", "name"), "L2 suite dataset id matches customer dataset")
  expect(dataset_ref["version"] == dataset.dig("metadata", "version"), "L2 suite dataset version matches")
  expect(dataset_ref["digest"] == dataset.dig("spec", "digest"), "L2 suite dataset digest matches")

  lock_dataset = (lock["evalDatasets"] || {})[dataset_ref["id"]].to_s
  lock_dataset_version, lock_dataset_digest = lock_dataset.split("@", 2)
  expect(lock_dataset_version == dataset_ref["version"], "lock evalDatasets version matches Eval Suite")
  expect(lock_dataset_digest == dataset_ref["digest"], "lock evalDatasets digest matches Eval Suite")

  suite_source = ROOT.join("acme/eval/claims-triage-quality/eval-suite.yaml")
  expect(suite_source.file?, "concrete eval suite source exists")
  expect(!(lock.dig("assets", "evalSuites", "claims-triage-quality", "files") || {}).empty?,
         "eval suite asset has a file manifest")
  metric_ids = (metric_catalog.dig("spec", "metrics") || []).map { |m| m["metricId"] }
  (eval_suite.dig("spec", "gates") || []).each do |gate|
    expect(metric_ids.include?(gate["metricRef"]), "gate #{gate["id"]} metric exists in catalog")
  end
else
  expect(false, "eval artifacts are readable")
end

puts "== Generated tree =="
generated_manifest = yaml(GEN.join("GENERATED.yaml"))
expect(!generated_manifest.nil?, "GENERATED.yaml is readable")
if generated_manifest
  expected_files = %w[
    mastra-app/src/mastra.ts
    mastra-app/src/agents/triage-agent.ts
    mastra-app/src/workflows/document-triage-flow.ts
    mastra-app/src/tools/claims-lookup.ts
    mastra-app/src/tools/claim-decision.ts
    mastra-app/src/runtime/context-client.ts
    context-service/app/main.py
    context-service/config/recipe.claims-context.yaml
    context-service/config/permissions.yaml
    context-service/config/sources.yaml
    context-service/migrations/001_audit_schema.sql
    context-service/migrations/002_graph_schema.yaml
    deploy/compose.yaml
    deploy/helm/Chart.yaml
    deploy/helm/values.yaml
    deploy/airgap/README.md
    sbom/THIRD_PARTY_NOTICES.md
  ]
  expected_files.each do |file|
    expect(GEN.join(file).file?, "generated #{file} exists")
  end

  (generated_manifest["sources"] || {}).each_key do |source|
    next if source.start_with?("solution.")

    expect(GEN.join(source).exist?, "GENERATED source #{source} exists")
  end

  compose = yaml(DEPLOY.join("compose.yaml"))
  if compose
    services = compose["services"] || {}
    (generated_manifest["components"] || {}).each_key do |component|
      expect(services.key?(component), "compose has service for component #{component}")
    end
    volumes = (compose["volumes"] || {}).keys
    (generated_manifest["volumes"] || {}).each_key do |volume|
      expect(volumes.include?(volume), "compose declares volume #{volume}")
    end
    expect(!(services.dig("context-service", "ports")), "context-service is not published on the host")
    expect(services.dig("mastra-app", "ports")&.any?, "mastra-app has a customer-facing port")
    expect(services.dig("context-service", "depends_on", "migrate", "condition") == "service_completed_successfully",
           "context-service waits for migrate")
    expect(services.dig("mastra-app", "depends_on", "context-service", "condition") == "service_healthy",
           "mastra-app waits for context-service")
  end

  package = JSON.parse(GEN.join("mastra-app/package.json").read)
  expect(package.dig("dependencies", "@mastra/core") == lock.dig("runtime", "mastra").to_s,
         "Mastra core version matches lock")
  expect(!package.dig("dependencies", "@mastra/editor"), "bundle does not depend on @mastra/editor")
end

puts "== Packaging =="
if system("which docker >/dev/null 2>&1")
  _out, err, status = Open3.capture3("docker", "compose", "config", "--quiet", chdir: DEPLOY.to_s)
  expect(status.success?, "docker compose config accepts compose.yaml#{err.empty? ? "" : ": #{err.strip}"}")
else
  warn("docker not found; compose validation skipped")
end

if system("which helm >/dev/null 2>&1")
  _out, err, status = Open3.capture3("helm", "template", "claims-triage", "helm", chdir: DEPLOY.to_s)
  expect(status.success?, "helm template renders the chart#{err.empty? ? "" : ": #{err.strip}"}")
else
  warn("helm not found; Helm rendering skipped")
end

puts "== Visible gaps =="
gap_lines = []
Dir.glob(ROOT.join("**/*")).sort.each do |path|
  next unless File.file?(path)
  next if path.end_with?("inspect.rb")
  next if path.include?("/sbom/")
  next if path.end_with?(".ttl", ".jsonl")

  File.readlines(path).each_with_index do |line, index|
    gap_lines << "#{Pathname.new(path).relative_path_from(ROOT)}:#{index + 1}: #{line.strip}" if line.include?("GAP:") || line.include?("PROPOSED:")
  end
end
puts gap_lines.uniq
warn("GAP: no `GAP:`/`PROPOSED:` markers found") if gap_lines.empty?

puts
puts "== Result =="
@ok.each { |message| puts "  OK   #{message}" }
@warnings.each { |message| puts "  WARN #{message}" }
@errors.each { |message| puts "  FAIL #{message}" }
puts
puts "#{@ok.size} ok, #{@warnings.size} warnings, #{@errors.size} failures"
exit(@errors.empty? ? 0 : 1)
