module.exports = {
    parser: '@typescript-eslint/parser',
    "env": {
        "node": true
    },
    "extends": [
        "eslint:recommended",
        'plugin:@typescript-eslint/recommended',
        'plugin:prettier/recommended'
    ],
    "parserOptions": {
        "ecmaVersion": "latest",
        "sourceType": "module"
    },
    plugins: ['@typescript-eslint', 'prettier'],
}
