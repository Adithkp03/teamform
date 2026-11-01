/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0f14',
        panel: '#12181f',
        line: '#22303c',
        accent: '#4fd1a5',
        accentDim: '#2a7d64',
        warn: '#f6c177',
        danger: '#eb6f92',
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};
