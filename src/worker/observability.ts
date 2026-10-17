import {monitorEventLoopDelay} from 'node:perf_hooks';

export class Responsiveness {
  private readonly histogram=monitorEventLoopDelay({resolution:20});
  private readonly reset:NodeJS.Timeout;
  constructor(){this.histogram.enable();this.reset=setInterval(()=>this.histogram.reset(),60_000);this.reset.unref();}
  snapshot(){return {p95Ms:Number((this.histogram.percentile(95)/1e6).toFixed(2)),maxMs:Number((this.histogram.max/1e6).toFixed(2)),windowSeconds:60};}
  close(){clearInterval(this.reset);this.histogram.disable();}
}
