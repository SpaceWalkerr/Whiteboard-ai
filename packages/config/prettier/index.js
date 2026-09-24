/** @type {import("prettier").Config} */
const config = {
  printWidth: 100,
  singleQuote: false,
  trailingComma: "all",
  plugins: ["prettier-plugin-tailwindcss"],
  // Tailwind class sorting only applies to the web app; the plugin ignores other files.
  tailwindStylesheet: "./apps/web/src/index.css",
  tailwindFunctions: ["cn", "cva"],
};

export default config;
