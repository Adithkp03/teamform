/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#f5f7fc',
        panel: '#ffffff',
        line: '#dbe3ef',
        accent: '#3456c9',
        accentDim: '#2743a8',
        warn: '#8c5100',
        danger: '#b62c43',
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};
