import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface FloatingReactionProps {
    id: string;
    emoji: string;
    onComplete: (id: string) => void;
}

/**
 * A single floating emoji reaction that animates upward in a zigzag pattern
 */
const FloatingReaction: React.FC<FloatingReactionProps> = ({ id, emoji, onComplete }) => {
    const [startX] = useState(() => Math.random() * 100); // Random start position 0-100%

    useEffect(() => {
        // Remove after animation completes (3 seconds)
        const timer = setTimeout(() => onComplete(id), 3000);
        return () => clearTimeout(timer);
    }, [id, onComplete]);

    return (
        <motion.div
            initial={{
                opacity: 1,
                y: 0,
                x: 0,
                scale: 0.5
            }}
            animate={{
                opacity: [1, 1, 0],
                y: -400,
                x: [0, 30, -20, 25, -15, 10, 0], // Zigzag pattern
                scale: [0.5, 1.2, 1, 0.9]
            }}
            transition={{
                duration: 3,
                ease: "easeOut",
                x: {
                    duration: 3,
                    ease: "easeInOut"
                }
            }}
            style={{
                position: 'absolute',
                right: `${10 + startX * 0.3}%`,
                bottom: '10%',
                pointerEvents: 'none',
                zIndex: 100
            }}
            className="text-4xl select-none drop-shadow-lg"
        >
            {emoji}
        </motion.div>
    );
};

interface FloatingReactionsContainerProps {
    reactions: Array<{ id: string; emoji: string }>;
    onReactionComplete: (id: string) => void;
}

/**
 * Container component that manages multiple floating reactions
 */
export const FloatingReactionsContainer: React.FC<FloatingReactionsContainerProps> = ({
    reactions,
    onReactionComplete
}) => {
    return (
        <div className="fixed inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 9999 }}>
            <AnimatePresence>
                {reactions.map((reaction) => (
                    <FloatingReaction
                        key={reaction.id}
                        id={reaction.id}
                        emoji={reaction.emoji}
                        onComplete={onReactionComplete}
                    />
                ))}
            </AnimatePresence>
        </div>
    );
};

// Common emojis that trigger reactions
export const REACTION_EMOJIS = ['😂', '❤️', '🔥', '👏', '😍', '🥳', '😮', '😢', '👍', '💯', '🎉', '😱'];

/**
 * Detect if a message contains reaction emojis
 */
export const extractReactionEmojis = (text: string): string[] => {
    const found: string[] = [];
    for (const emoji of REACTION_EMOJIS) {
        if (text.includes(emoji)) {
            found.push(emoji);
        }
    }
    return found;
};

export default FloatingReaction;
