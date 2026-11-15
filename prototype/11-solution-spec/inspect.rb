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

spec = yaml(SPEC_PATH)
lock = yaml(LOCK_PATH)
environment = yaml(ENV_PATH)
exit(1) unless spec && lock && environment

puts "== Spec and lock =="
expect(spec.dig("metadata", "customer") == "acme", "spec customer is acme")
expect(spec.dig("metadata", "solution") == "claims-triage", "spec solution is claims-triage")
expect(spec.dig("apiVersion") == "fde.dev/v0", "spec apiVersion is fde.dev/v0")
expect(lock["lockVersion"] == 1, "lock version is 1")

template_names = (lock["templates"] || {}).keys
extension_names = (lock["extensions"] || {}).keys
capabilities = spec.dig("spec", "capabilities") || {}
agents = spec.dig("spec", "agents") || {}
workflows = spec.dig("spec", "workflows") || {}
tools = spec.dig("spec", "tools") || {}

capabilities.each do |name, capability|
  template = capability["template"].to_s.split("@").first
  expect(template_names.include?(template), "capability #{name} template #{template} is pinned")
  impl = capability["implementation"] || {}
  if impl["type"] == "agent"
    expect(agents.key?(impl["ref"]), "capability #{name} agent #{impl["ref"]} exists")
  elsif impl["type"] == "workflow"
    expect(workflows.key?(impl["ref"]), "capability #{name} workflow #{impl["ref"]} exists")
  else
    expect(false, "capability #{name} has a known implementation type")
  end
  (capability["policyRefs"] || []).each do |ref|
    expect(template_names.include?(ref.split("@").first), "capability #{name} policy #{ref} is pinned")
  end
  (capability["evalRefs"] || []).each do |ref|
    expect(template_names.include?(ref.split("@").first), "capability #{name} eval #{ref} is pinned")
  end
end

agents.each do |name, agent|
  (agent["tools"] || []).each do |tool|
    expect(tools.key?(tool), "agent #{name} tool #{tool} exists")
  end
  if agent["modelProfile"] && !(lock["modelProfiles"] || {}).key?(agent["modelProfile"])
    warn("GAP: agent #{name} references modelProfile #{agent["modelProfile"]}, but solution.lock does not pin model profiles")
  end
  instructions = agent["instructions"]
  expect(SPEC_DIR.join(instructions).file?, "agent #{name} instructions #{instructions} exist") if instructions
end

PLATFORM_ROLES = %w[end_user approver customer_admin deployment_operator auditor service support].freeze

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
workflows.each do |name, workflow|
  steps = workflow["steps"] || []
  _capability_name, capability = capabilities.find do |_, candidate|
    candidate.dig("implementation", "ref") == name
  end
  bound_policies = (capability&.dig("policyRefs") || []).map { |ref| ref.split("@").first }

  steps.each_with_index do |step, index|
    case step["type"]
    when "agent"
      expect(agents.key?(step["agent"]), "workflow #{name} step #{step["id"]} agent #{step["agent"]} exists")
      if step["outputSchema"]
        expect(SPEC_DIR.join(step["outputSchema"]).file?,
               "workflow #{name} step #{step["id"]} outputSchema exists")
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
        expect(template_names.include?(predicate_ref.split("@").first),
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
  %w[inputSchema outputSchema].each do |field|
    next unless tool[field]

    expect(SPEC_DIR.join(tool[field]).file?, "tool #{name} #{field} exists")
  end
end

(spec.dig("spec", "governance", "evalSuites") || []).each do |ref|
  expect(template_names.include?(ref.split("@").first), "governance eval #{ref} is pinned")
end
(spec.dig("spec", "overlays") || []).each do |ref|
  expect(template_names.include?(ref.split("@").first), "overlay #{ref} is pinned")
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
