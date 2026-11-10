// Vite raw imports (used by tests to read config files inside the Workers pool).
declare module "*?raw" {
  const text: string;
  export default text;
}
