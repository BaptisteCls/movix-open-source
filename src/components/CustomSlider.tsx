import React, { useRef, useState, useEffect } from 'react';

interface CustomSliderProps {
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (value: number) => void;
    onCommit?: (value: number) => void;
    className?: string;
}

const CustomSlider: React.FC<CustomSliderProps> = ({
    min,
    max,
    step,
    value,
    onChange,
    onCommit,
    className = "",
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);

    // Internal state to track value during drag for immediate feedback without parent round-trip latency
    const [internalValue, setInternalValue] = useState(value);
    const latestInternalValueRef = useRef(value);

    // Synchronize internal state with prop value when NOT dragging
    useEffect(() => {
        if (!isDragging) {
            setInternalValue(value);
            latestInternalValueRef.current = value;
        }
    }, [value, isDragging]);

    const percentage = ((internalValue - min) / (max - min)) * 100;

    const calculateValue = (clientX: number) => {
        if (!containerRef.current) return internalValue;

        const rect = containerRef.current.getBoundingClientRect();
        const x = clientX - rect.left;
        const width = rect.width;

        let newValue = (x / width) * (max - min) + min;
        newValue = Math.max(min, Math.min(max, newValue));

        // Apply step precision but keep it fluid if step is small
        if (step > 0) {
            newValue = Math.round(newValue / step) * step;
        }

        return newValue;
    };

    const handleInteraction = (clientX: number, commit: boolean = false) => {
        const newValue = calculateValue(clientX);

        setInternalValue(newValue);
        latestInternalValueRef.current = newValue;

        if (!commit) {
            onChange(newValue);
        } else if (onCommit) {
            onCommit(newValue);
        } else {
            onChange(newValue);
        }
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault(); // Prevent text selection
        setIsDragging(true);
        handleInteraction(e.clientX);
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        setIsDragging(true);
        handleInteraction(e.touches[0].clientX);
    };

    useEffect(() => {
        if (!isDragging) return;

        const handleMouseMove = (e: MouseEvent) => {
            handleInteraction(e.clientX);
        };

        const handleTouchMove = (e: TouchEvent) => {
            handleInteraction(e.touches[0].clientX);
        };

        const handleMouseUp = (e: MouseEvent) => {
            setIsDragging(false);
            if (onCommit) {
                onCommit(latestInternalValueRef.current);
            }
        };

        const handleTouchEnd = () => {
            setIsDragging(false);
            if (onCommit) {
                onCommit(latestInternalValueRef.current);
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        document.addEventListener('touchmove', handleTouchMove);
        document.addEventListener('touchend', handleTouchEnd);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('touchmove', handleTouchMove);
            document.removeEventListener('touchend', handleTouchEnd);
        };
    }, [isDragging, min, max, step, onCommit, onChange]);

    return (
        <div
            className={`relative h-6 flex items-center select-none cursor-pointer touch-none ${className}`}
            ref={containerRef}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
        >
            {/* Track Background */}
            <div className="absolute left-0 right-0 h-2 bg-gray-700 rounded-full overflow-hidden">
                {/* Progress Bar - Disable transition during drag for 1:1 feel */}
                <div
                    className={`h-full bg-red-600 ${isDragging ? '' : 'transition-all duration-150 ease-out'}`}
                    style={{ width: `${percentage}%` }}
                />
            </div>

            {/* Thumb - Use simpler positioning */}
            <div
                className={`absolute top-1/2 -translate-y-1/2 w-5 h-5 bg-white rounded-full shadow-lg ${isDragging ? '' : 'transition-all duration-100 ease-out'} hover:scale-110 active:scale-125 focus:outline-none focus:ring-2 focus:ring-red-500`}
                style={{
                    left: `${percentage}%`,
                    transform: `translate(-50%, -50%)` // Center thumb on exact point
                }}
            />
        </div>
    );
};

export default CustomSlider;
