import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface HexagonBackgroundProps extends React.HTMLAttributes<HTMLDivElement> {
    hexagonSize?: number;
    hexagonMargin?: number;
    color?: string;
    highlightColor?: string;
}

export const HexagonBackground: React.FC<HexagonBackgroundProps> = ({
    children,
    className,
    hexagonSize = 50,
    hexagonMargin = 3,
    color = '#f21010ff',
    highlightColor = '#fbbf24', // Amber-400 equivalent for the 'light' effect
    ...props
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const mouseRef = useRef({ x: 0, y: 0 });

    useEffect(() => {
        const updateDimensions = () => {
            if (containerRef.current) {
                const { clientWidth, clientHeight } = containerRef.current;
                setDimensions({ width: clientWidth, height: clientHeight });
            }
        };

        window.addEventListener('resize', updateDimensions);
        updateDimensions();

        return () => window.removeEventListener('resize', updateDimensions);
    }, []);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                mouseRef.current = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                };
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;

        const render = () => {
            const { width, height } = dimensions;
            const dpr = window.devicePixelRatio || 1;

            // Ensure canvas size is correct
            if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
                canvas.width = width * dpr;
                canvas.height = height * dpr;
                ctx.scale(dpr, dpr);
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
            }

            ctx.clearRect(0, 0, width, height);

            const r = hexagonSize;
            const a = 2 * Math.PI / 6;
            const xSpacing = Math.sqrt(3) * r + hexagonMargin;
            const ySpacing = (3 / 2) * r + hexagonMargin;
            const rows = Math.ceil(height / ySpacing) + 2;
            const cols = Math.ceil(width / xSpacing) + 2;

            // Draw function
            const drawHexagon = (x: number, y: number) => {
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    ctx.lineTo(x + r * Math.cos(a * i), y + r * Math.sin(a * i));
                }
                ctx.closePath();

                // Calculate distance from mouse
                const dist = Math.hypot(x - mouseRef.current.x, y - mouseRef.current.y);
                const maxDist = 400; // Spotlight radius

                // Base opacity
                const baseOpacity = 0.1;

                // Spotlight opacity
                let opacity = baseOpacity;
                if (dist < maxDist) {
                    const bonus = (1 - dist / maxDist) * 0.4;
                    opacity += bonus;
                }

                ctx.strokeStyle = color;
                ctx.globalAlpha = opacity;
                ctx.lineWidth = 1;
                ctx.stroke();

                // Optional: Highlight fill for very close hexagons
                if (dist < 150) {
                    ctx.fillStyle = highlightColor;
                    ctx.globalAlpha = (1 - dist / 150) * 0.1;
                    ctx.fill();
                }

                ctx.globalAlpha = 1; // Reset
            };

            for (let row = -1; row < rows; row++) {
                for (let col = -1; col < cols; col++) {
                    let x = col * xSpacing;
                    const y = row * ySpacing;
                    if (row % 2 !== 0) x += xSpacing / 2;
                    drawHexagon(x, y);
                }
            }

            animationFrameId = requestAnimationFrame(render);
        };

        render();

        return () => cancelAnimationFrame(animationFrameId);
    }, [dimensions, hexagonSize, hexagonMargin, color, highlightColor]);

    return (
        <div ref={containerRef} className={cn("relative overflow-hidden bg-black", className)} {...props}>
            <canvas
                ref={canvasRef}
                className="absolute inset-0 z-0 pointer-events-none"
            />
            <div className="relative z-10 w-full h-full">
                {children}
            </div>
        </div>
    );
};
