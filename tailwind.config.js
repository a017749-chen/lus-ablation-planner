/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        med: {
          dark: '#080d14',
          panel: 'rgba(13, 20, 32, 0.85)',
          border: 'rgba(38, 55, 82, 0.6)',
          accent: '#00d2ff',
          neon: '#00ff66',
          warning: '#ffb800',
          danger: '#ff334b',
          purple: '#9d4edd',
        }
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'glow-neon': '0 0 15px rgba(0, 255, 102, 0.4)',
        'glow-cyan': '0 0 15px rgba(0, 210, 255, 0.35)',
        'glow-danger': '0 0 20px rgba(255, 51, 75, 0.5)',
      }
    },
  },
  plugins: [],
}
