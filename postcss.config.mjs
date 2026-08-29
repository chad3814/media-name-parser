// Tailwind v4 is CSS-first: the plugin is the whole configuration, and there
// is deliberately no tailwind.config.js. Utilities come from `@import
// "tailwindcss"` in app/globals.css.
const config = { plugins: { '@tailwindcss/postcss': {} } };

export default config;
