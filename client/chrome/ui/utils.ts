import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class merger: later Tailwind utilities win over earlier ones, so a
 *  caller's `className` can override a component's defaults by name rather than
 *  by specificity. Every vendored component below is authored against it. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
