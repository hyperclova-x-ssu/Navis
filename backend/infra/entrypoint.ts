export {};

const workload = process.argv[2];

try {
  switch (workload) {
    case 'account':
    case 'inventory':
      await import(`../services/${workload}/index.ts`);
      break;
    case 'api-gateway':
      await import('../gateway/index.ts');
      break;
    default:
      throw new Error('Unknown workload');
  }
} catch {
  console.error(JSON.stringify({ service: workload, level: 50, msg: 'Workload initialization failed' }));
  process.exitCode = 1;
}
