import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

function NativeSelect({ className, children, ...props }) {
  return <div className="relative">
    <select data-slot="native-select" className={cn(
      'h-10 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-9 text-sm shadow-xs outline-none dark:bg-input/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
      className,
    )} {...props}>{children}</select>
    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
  </div>;
}

export { NativeSelect };
