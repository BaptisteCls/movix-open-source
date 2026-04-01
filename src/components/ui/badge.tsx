import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
    {
        variants: {
            variant: {
                default: "bg-black/60 text-white border border-white/10 backdrop-blur-md",
                pending: "bg-amber-950/80 text-amber-200 border border-amber-500/30 backdrop-blur-md",
                not_found: "bg-orange-950/80 text-orange-200 border border-orange-500/30 backdrop-blur-md",
                not_found_recent: "bg-orange-950/80 text-orange-200 border border-orange-500/30 backdrop-blur-md",
                searching: "bg-blue-950/80 text-blue-200 border border-blue-500/30 backdrop-blur-md",
                added: "bg-green-950/80 text-green-200 border border-green-500/30 backdrop-blur-md",
                rejected: "bg-red-950/80 text-red-200 border border-red-500/30 backdrop-blur-md",
                movie: "bg-blue-600/80 text-white backdrop-blur-md shadow-sm",
                tv: "bg-purple-600/80 text-white backdrop-blur-md shadow-sm",
                premium: "bg-gradient-to-r from-amber-600/80 to-orange-600/80 text-white border border-amber-500/30",
                secondary: "bg-white/10 text-white hover:bg-white/20 border border-transparent backdrop-blur-md",
                outline: "text-white border border-white/20 bg-transparent backdrop-blur-md",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
);

export interface BadgeProps
    extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> { }

function Badge({ className, variant, ...props }: BadgeProps) {
    return (
        <div className={cn(badgeVariants({ variant }), className)} {...props} />
    );
}

export { Badge, badgeVariants };
