import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
    extends React.InputHTMLAttributes<HTMLInputElement> { }

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({ className, type, ...props }, ref) => {
        return (
            <input
                type={type}
                className={cn(
                    "flex h-10 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/50",
                    "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-white",
                    "hover:bg-white/[0.07] focus:bg-white/10",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "transition-all duration-200 backdrop-blur-sm",
                    className
                )}
                ref={ref}
                {...props}
            />
        );
    }
);
Input.displayName = "Input";

export { Input };
