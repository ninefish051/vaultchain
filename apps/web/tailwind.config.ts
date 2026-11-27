import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#0B0B0C", 900: "#0B0B0C", 800: "#131315", 700: "#1C1C1F", 600: "#26262A", 500: "#3A3A40" },
        gold: { DEFAULT: "#E8B84A", 300: "#F3D489", 400: "#EDC566", 500: "#E8B84A", 600: "#C9982F", 700: "#9C7420" },
        up: "#3FBF7F",
        down: "#E5484D",
      },
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"], mono: ["ui-monospace", "SFMono-Regular", "monospace"] },
    },
  },
  plugins: [],
} satisfies Config;
