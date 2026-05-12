// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
    exports: 'named'
  },
  plugins: [
    typescript(),
    nodeResolve({ preferBuiltins: true }),
    commonjs({
      strictRequires: true
    })
  ],
  onwarn(warning) {
    // Suppress known harmless warnings from dependencies
    if (
      warning.code === 'THIS_IS_UNDEFINED' ||
      warning.code === 'CIRCULAR_DEPENDENCY'
    ) {
      return
    }
    // Show other warnings
    console.warn(warning.message)
  }
}

export default config
