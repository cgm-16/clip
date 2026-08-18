import next from 'eslint-config-next';

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'design/**', 'generated/**'] },
  ...next,
];

export default config;
