import * as React from "react";
import { cn } from "../../lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "flex min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-all duration-150 placeholder:text-muted-foreground",
          "hover:border-primary/40 hover:bg-accent/5",
          "focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-0 focus-visible:shadow-[0_0_0_3px_hsl(214_55%_55%/0.12),0_0_16px_hsl(214_55%_55%/0.18)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    );
  }
);
