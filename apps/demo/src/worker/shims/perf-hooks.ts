/** `node:perf_hooks` nel browser (D221). */
const performanceRef = globalThis.performance;
export class PerformanceObserver {
  observe() {}
  disconnect() {}
}
export const monitorEventLoopDelay = () => ({
  enable() {},
  disable() {},
  percentile: () => 0,
  mean: 0,
  max: 0,
  min: 0,
  reset() {},
});
export { performanceRef as performance };
export default { performance: performanceRef, PerformanceObserver, monitorEventLoopDelay };
