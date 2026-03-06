import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../../"),
  webpack(config, { isServer }) {
    if (isServer) {
      config.ignoreWarnings = [
        ...(config.ignoreWarnings ?? []),
        {
          module: /@opentelemetry\/instrumentation/,
          message: /Critical dependency: the request of a dependency is an expression/,
        },
        {
          module: /require-in-the-middle/,
          message:
            /Critical dependency: require function is used in a way in which dependencies cannot be statically extracted/,
        },
      ];
    }

    return config;
  },
};

export default nextConfig;
