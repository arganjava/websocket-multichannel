module.exports = {
  testEnvironment: 'node',
  // Automatically clear mock calls and instances between every test
  clearMocks: true,
  // The directory where Jest should output its coverage files
  coverageDirectory: 'coverage',
  // An array of glob patterns indicating a set of files for which coverage information should be collected
  collectCoverageFrom: ['src/**/*.js'],
  // Setup a file to run before all tests to set environment variables or other global setups
  // setupFilesAfterEnv: ['./tests/setupEnv.js'], // Example if needed
  // Indicates whether each individual test should be reported during the run
  verbose: true,
};
