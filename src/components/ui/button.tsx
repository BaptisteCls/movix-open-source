import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
    size?: "default" | "sm" | "lg" | "icon";
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "default", size = "default", ...props }, ref) => {
        const baseStyles = "inline-flex items-center justify-center font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:pointer-events-none disabled:opacity-50 active:scale-95";

        const variants = {
            default: "bg-red-600 text-white hover:bg-red-700 shadow-lg shadow-red-500/20",
            destructive: "bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30",
            outline: "border border-white/10 bg-transparent text-white hover:bg-white/10",
            secondary: "bg-white/10 text-white hover:bg-white/20",
            ghost: "text-white/70 hover:bg-white/10 hover:text-white",
            link: "text-red-400 underline-offset-4 hover:underline",
        };

        const sizes = {
            default: "h-10 px-4 py-2 rounded-lg text-sm",
            sm: "h-8 px-3 rounded-md text-xs",
            lg: "h-12 px-6 rounded-lg text-base",
            icon: "h-10 w-10 rounded-lg",
        };

        return (
            <button
                className={cn(baseStyles, variants[variant], sizes[size], className)}
                ref={ref}
                {...props}
            />
        );
    }
);
Button.displayName = "Button";

export { Button };
