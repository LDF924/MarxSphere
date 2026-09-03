import * as React from "react";

import { cn } from "../lib/utils";

export function SettingsSection({
  title,
  description,
  children,
  footer,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <header className="px-1">
        <h2 className="text-base font-semibold leading-6">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="overflow-hidden rounded-lg border bg-card shadow-soft">
        {children}
        {footer && <div className="border-t px-4 py-3 sm:px-5">{footer}</div>}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  children,
  layout = "stacked",
  className,
  contentClassName,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  layout?: "inline" | "stacked";
  className?: string;
  contentClassName?: string;
}) {
  const inline = layout === "inline";

  return (
    <div
      className={cn(
        "border-t p-4 first:border-t-0 sm:p-5",
        inline
          ? "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          : "grid gap-4",
        className,
      )}
    >
      <div className={cn("min-w-0", inline && "sm:max-w-md")}>
        <div className="text-sm font-medium leading-5">{title}</div>
        {description && (
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      <div
        className={cn(
          "min-w-0",
          inline ? "sm:shrink-0" : "w-full",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
