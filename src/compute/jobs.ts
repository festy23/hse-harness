import type { CalendarComputeJob } from '../calendar/compute.js';

export interface HtmlComputeJob {
  type: 'html';
  mode: 'hse' | 'mail';
  html: string;
  baseUrl?: string;
  maxBytes?: number;
}
export interface HtmlComputeResult {
  text: string;
  links: string[];
}
export type ComputeJob = HtmlComputeJob | CalendarComputeJob;
