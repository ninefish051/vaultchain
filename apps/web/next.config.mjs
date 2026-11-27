/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@vaultchain/shared"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.pokemontcg.io" }],
  },
  webpack: (config) => {
    // wagmi connectors pull optional deps that are not needed in the browser bundle
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // @coinbase/cdp-sdk (pulled in by the Base Account connector) lazily imports optional x402
    // packages we never call; stub them out so the bundle resolves.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/svm/exact/client": false,
      "@react-native-async-storage/async-storage": false, // MetaMask SDK, React Native only
    };
    return config;
  },
};

export default nextConfig;
