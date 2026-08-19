import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.tsx` as well as `.ts`: component files hold testable logic too, and a
    // pattern that cannot match them quietly makes half of src untestable.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
