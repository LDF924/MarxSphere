import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_12px_hsl(213_42%_42%/0.3)] hover:shadow-[0_0_18px_hsl(214_55%_55%/0.45)] hover:-translate-y-px",
        secondary: "bg-muted text-foreground hover:bg-muted/80",
        ghost: "hover:bg-accent/20 hover:text-accent-foreground",
        outline: "border border-border glass hover:bg-accent/20 hover:border-primary/40",
        destructive: "bg-red-600 text-white hover:bg-red-700 hover:shadow-[0_0_14px_hsl(0_72%_51%/0.35)]"
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        icon: "h-9 w-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}
