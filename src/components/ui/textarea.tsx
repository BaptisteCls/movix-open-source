import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps
    extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { }

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, ...props }, ref) => {
        return (
            <textarea
                className={cn(
                    "flex min-h-[80px] w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/50",
                    "hover:bg-white/[0.07] focus:bg-white/10",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "transition-all duration-200 backdrop-blur-sm resize-none",
                    className
                )}
                ref={ref}
                {...props}
            />
        );
    }
);
Textarea.displayName = "Textarea";

export { Textarea };
