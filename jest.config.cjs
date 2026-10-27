module.exports = {
  testEnvironment: 'node',
  // Only official maintained suites live here. Never crawl nested checkouts or .tmp.
  roots: ['<rootDir>/verification'],
  testMatch: ['**/*.spec.cjs', '**/*.spec.ts'],
  setupFiles: ['<rootDir>/verification/setup.cjs'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'Node',
          target: 'ES2023',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/\\.tmp/',
    '<rootDir>/brandora-author-fix/',
    '/(?:archive|archives|archived)/',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/\\.tmp/',
    '<rootDir>/brandora-author-fix/',
  ],
};
