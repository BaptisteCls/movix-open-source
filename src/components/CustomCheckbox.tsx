import React from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';

interface CustomCheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: React.ReactNode;
    icon?: React.ReactNode;
    className?: string;
    disabled?: boolean;
}

const CustomCheckbox: React.FC<CustomCheckboxProps> = ({
    checked,
    onChange,
    label,
    icon,
    className = '',
    disabled = false
}) => {
    return (
        <label
            className={`
        flex items-center gap-3 p-3 
        bg-gray-700/80 border border-gray-600 rounded-lg 
        cursor-pointer transition-colors hover:bg-gray-600
        select-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''} 
        ${className}
      `}
            onClick={(e) => {
                if (disabled) {
                    e.preventDefault();
                    return;
                }
            }}
        >
            <div className="relative flex items-center">
                <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked)}
                    disabled={disabled}
                />
                <motion.div
                    className={`
            w-5 h-5 rounded border flex items-center justify-center
            transition-colors duration-200
            ${checked
                            ? 'bg-red-600 border-red-600'
                            : 'bg-gray-800 border-gray-500 hover:border-gray-400'
                        }
          `}
                    animate={{ scale: checked ? 1.05 : 1 }}
                    whileTap={{ scale: 0.95 }}
                >
                    {checked && (
                        <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            exit={{ scale: 0 }}
                        >
                            <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
                        </motion.div>
                    )}
                </motion.div>
            </div>

            <div className="flex items-center gap-2 text-sm text-gray-200">
                {icon}
                <span>{label}</span>
            </div>
        </label>
    );
};

export default CustomCheckbox;
