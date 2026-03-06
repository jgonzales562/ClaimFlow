import rootConfig from "../../eslint.config.mjs";
import nextPlugin from "@next/eslint-plugin-next";

export default [
  ...rootConfig,
  {
    files: ["eslint.config.mjs"],
    plugins: {
      "@next/next": nextPlugin,
    },
  },
];
