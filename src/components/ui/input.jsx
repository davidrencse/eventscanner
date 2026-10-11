import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }) {
  return <input type={type} data-slot="input" className={cn(
    'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground disabled:pointer-events-none disabled:opacity-50 md:text-sm dark:bg-input/30',
    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
    className,
  )} {...props} />;
}

export { Input };
