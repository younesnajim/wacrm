"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

// Root: primary token when checked (responds to the active color theme),
// slate when unchecked.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[checked]:bg-primary data-[unchecked]:bg-muted",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-card shadow-sm ring-0 transition-transform",
          // The thumb's rest position isn't set by a logical CSS property
          // at all — it comes from the track's plain `flex` row, whose
          // main-axis start is already direction-aware natively (right in
          // RTL, no class needed). But `data-[checked]:translate-x-4` is a
          // hardcoded physical shift: in RTL the thumb already rests on
          // the right, so shifting further +4 pushes it off the track
          // instead of across it. `rtl:data-[checked]:-translate-x-4`
          // supplies the mirror-image shift.
          "data-[checked]:translate-x-4 rtl:data-[checked]:-translate-x-4 data-[unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
