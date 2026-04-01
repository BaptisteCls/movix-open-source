import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface ReusableModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: React.ReactNode;
    className?: string; // For customized width/height if needed
}

const ReusableModal: React.FC<ReusableModalProps> = ({
    isOpen,
    onClose,
    title,
    children,
    className = "max-w-2xl"
}) => {
    const [isClosing, setIsClosing] = useState(false);

    // Disable body scroll when modal is open
    useEffect(() => {
        if (!isOpen) return;

        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, [isOpen]);

    const handleClose = () => {
        setIsClosing(true);
        setTimeout(() => {
            onClose();
            setIsClosing(false);
        }, 300); // Matches animation duration
    };

    if (!isOpen) return null;

    const modalContent = (
        <AnimatePresence mode="wait">
            {isOpen && !isClosing && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) handleClose();
                    }}
                >
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className={`bg-gray-900 border border-white/10 rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl ${className}`}
                    >
                        {/* Header */}
                        <div className="flex justify-between items-center p-6 border-b border-white/10 shrink-0">
                            <h3 className="text-xl font-bold text-white">{title}</h3>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={handleClose}
                                className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </motion.button>
                        </div>

                        {/* Content */}
                        <div className="overflow-y-auto p-6" data-lenis-prevent style={{ overscrollBehavior: 'contain' }}>
                            {children}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    return createPortal(modalContent, document.body);
};

export default ReusableModal;
