import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				sourceType: 'module',
				ecmaVersion: 2022,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			'@typescript-eslint/no-unused-vars': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			eqeqeq: 'error',
			curly: 'error',
			'no-throw-literal': 'error',
		},
	},
];
