/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['"IBM Plex Sans"', 'sans-serif'],
      },
      colors: {
        surface: '#0d1117',
        panel: '#161b22',
        border: '#30363d',
        accent: '#f78166',
        'accent-2': '#58a6ff',
        success: '#3fb950',
        warning: '#d29922',
        danger: '#f85149',
        critical: '#ff6e6e',
        muted: '#8b949e',
      },
    },
  },
  plugins: [],
}
