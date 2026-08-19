// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import * as React from "react";
import { cn } from "../../lib/utils";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}
