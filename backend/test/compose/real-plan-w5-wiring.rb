require 'yaml'
require 'open3'

backend = File.expand_path('../..', __dir__)
rendered, status = Open3.capture2('kubectl', 'kustomize', File.join(backend, 'deploy/nks/overlays/w5'))
abort 'Kustomize rendering failed' unless status.success?
documents = YAML.load_stream(rendered).compact

def deployment(documents, name)
  resource = documents.find { |doc| doc['kind'] == 'Deployment' && doc.dig('metadata', 'name') == name }
  abort "Missing deployment for #{name}" unless resource
  resource.fetch('spec').fetch('template').fetch('spec')
end

def assert_secret(documents, service, variable, key)
  pod = deployment(documents, service)
  env = pod.fetch('containers').first.fetch('env').find { |entry| entry['name'] == variable }
  abort "#{service} must read #{variable} from its projected mount" unless env && env['value'] == "/run/secrets/#{key}"
  tokens = pod.fetch('volumes').find { |volume| volume['name'] == 'secrets' }.dig('projected', 'sources')
    .find { |source| source.dig('secret', 'name') == 'navis-tokens' }.dig('secret', 'items')
  abort "#{service} must mount #{key} from navis-tokens" unless tokens.include?({ 'key' => key, 'path' => key })
end

def assert_network(documents, source, target, port)
  policies = documents.select { |doc| doc['kind'] == 'NetworkPolicy' && doc.dig('metadata', 'namespace') == 'navis' }
  { 'egress' => [source, 'to', target], 'ingress' => [target, 'from', source] }.each do |direction, (local, peers, remote)|
    rules = policies.select { |doc| doc.dig('spec', 'podSelector', 'matchLabels', 'app.kubernetes.io/name') == local }
      .flat_map { |doc| doc.dig('spec', direction) || [] }
    permitted = rules.any? do |rule|
      rule.fetch(peers, []).any? { |peer| peer.dig('podSelector', 'matchLabels', 'app.kubernetes.io/name') == remote } &&
        rule.fetch('ports', []).any? { |entry| entry['protocol'] == 'TCP' && entry['port'] == port }
    end
    abort "Missing #{direction} policy for #{source} → #{target}:#{port}" unless permitted
  end
end

if ARGV.include?('--members')
  assert_secret(documents, 'pos', 'NAVIS_POS_CUSTOMER_TOKEN_FILE', 'pos_customer_token')
  assert_secret(documents, 'customer', 'NAVIS_POS_CUSTOMER_TOKEN_FILE', 'pos_customer_token')
  assert_secret(documents, 'pos', 'NAVIS_CUSTOMER_POS_TOKEN_FILE', 'customer_pos_token')
  assert_network(documents, 'pos', 'customer', 3000)
  assert_network(documents, 'customer', 'pos', 3000)
elsif ARGV.include?('--stock-worker')
  worker = deployment(documents, 'inventory-stock-worker')
  container = worker.fetch('containers').first
  abort 'Stock worker must run the standalone consumer' unless
    container['command'] == ['node', 'services/inventory/stock-worker.ts']
  mounted_keys = worker.fetch('volumes').find { |volume| volume['name'] == 'secrets' }.dig('projected', 'sources')
    .flat_map { |source| source.dig('secret', 'items').map { |item| item['key'] } }
  abort 'Stock worker requires only worker and Redis credentials' unless
    mounted_keys.sort == %w[inventory_redis_password inventory_wrk_password]
  assert_network(documents, 'inventory-stock-worker', 'redis', 6379)
elsif ARGV.include?('--receipt-worker')
  worker = deployment(documents, 'pos-receipt-worker')
  container = worker.fetch('containers').first
  abort 'Receipt worker must run the standalone consumer' unless
    container['command'] == ['node', 'workers/pos-receipts/index.ts']
  sources = worker.fetch('volumes').find { |volume| volume['name'] == 'secrets' }.dig('projected', 'sources')
  keys = sources.to_h { |source| [source.dig('secret', 'name'), source.dig('secret', 'items').map { |item| item['key'] }] }
  abort 'Receipt worker requires only its POS worker and Redis credentials' unless
    keys == { 'navis-db' => ['pos_wrk_password'], 'navis-redis' => ['pos_redis_password'] }
  abort 'Receipt worker must have no Service' if documents.any? { |doc| doc['kind'] == 'Service' && doc.dig('metadata', 'name') == 'pos-receipt-worker' }
  assert_network(documents, 'pos-receipt-worker', 'redis', 6379)
elsif ARGV.include?('--custom-reference')
  assert_secret(documents, 'pos', 'NAVIS_POS_ACCOUNT_TOKEN_FILE', 'pos_account_token')
  assert_secret(documents, 'account', 'NAVIS_POS_ACCOUNT_TOKEN_FILE', 'pos_account_token')
  pos_env = deployment(documents, 'pos').fetch('containers').first.fetch('env')
  abort 'POS must use the private Account origin' unless pos_env.include?({ 'name' => 'NAVIS_POS_ACCOUNT_URL', 'value' => 'http://account:3000' })
  assert_network(documents, 'pos', 'account', 3000)
else
  assert_secret(documents, 'pos', 'NAVIS_GATEWAY_POS_TOKEN_FILE', 'gateway_pos_token')
  assert_secret(documents, 'pos', 'NAVIS_POS_INVENTORY_TOKEN_FILE', 'pos_inventory_token')
  assert_secret(documents, 'inventory', 'NAVIS_POS_INVENTORY_TOKEN_FILE', 'pos_inventory_token')
  assert_secret(documents, 'inventory', 'NAVIS_INVENTORY_ACCOUNT_TOKEN_FILE', 'inventory_account_token')
  assert_secret(documents, 'account', 'NAVIS_INVENTORY_ACCOUNT_TOKEN_FILE', 'inventory_account_token')
  { 'pos' => ['NAVIS_POS_INVENTORY_URL', 'http://inventory:3000'],
    'inventory' => ['NAVIS_INVENTORY_ACCOUNT_URL', 'http://account:3000'] }.each do |service, (name, value)|
    env = deployment(documents, service).fetch('containers').first.fetch('env')
    abort "#{service} must call #{value}" unless env.include?({ 'name' => name, 'value' => value })
  end
  assert_network(documents, 'pos', 'inventory', 3000)
  assert_network(documents, 'inventory', 'account', 3000)
end

puts 'Rendered W5 wiring verified'
