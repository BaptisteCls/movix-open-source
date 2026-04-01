import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

interface CustomDatePickerProps {
  value?: Date;
  onChange: (date: Date | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  position?: 'bottom' | 'top';
  minDate?: Date;
  maxDate?: Date;
}

const CustomDatePicker: React.FC<CustomDatePickerProps> = ({
  value,
  onChange,
  placeholder = i18n.t('common.selectDate'),
  disabled = false,
  className = '',
  position = 'bottom',
  minDate,
  maxDate
}) => {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(value);
  const [currentMonth, setCurrentMonth] = useState<Date>(value || new Date());
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Mettre à jour la date sélectionnée quand la prop value change
  useEffect(() => {
    setSelectedDate(value);
    if (value) {
      setCurrentMonth(new Date(value.getFullYear(), value.getMonth(), 1));
    }
  }, [value]);

  // Fermer le dropdown quand on clique à l'extérieur
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggle = () => {
    if (disabled) return;
    setIsOpen(!isOpen);
  };

  const handleDateSelect = (date: Date) => {
    setSelectedDate(date);
    onChange(date);
    setIsOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedDate(undefined);
    onChange(undefined);
  };

  const formatDate = (date: Date | undefined) => {
    if (!date) return '';
    return date.toLocaleDateString(i18n.language, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const getDaysArray = (date: Date) => {
    const daysInMonth = getDaysInMonth(date);
    const firstDay = getFirstDayOfMonth(date);
    const days = [];

    // Ajouter les jours vides du mois précédent
    for (let i = 0; i < firstDay; i++) {
      days.push(null);
    }

    // Ajouter les jours du mois
    for (let day = 1; day <= daysInMonth; day++) {
      days.push(new Date(date.getFullYear(), date.getMonth(), day));
    }

    return days;
  };

  const isDateDisabled = (date: Date) => {
    if (minDate && date < minDate) return true;
    if (maxDate && date > maxDate) return true;
    return false;
  };

  const isDateSelected = (date: Date) => {
    if (!selectedDate) return false;
    return date.toDateString() === selectedDate.toDateString();
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    setCurrentMonth(prev => {
      const newMonth = new Date(prev);
      if (direction === 'prev') {
        newMonth.setMonth(prev.getMonth() - 1);
      } else {
        newMonth.setMonth(prev.getMonth() + 1);
      }
      return newMonth;
    });
  };

  const monthNames = (t('common.monthNames', { returnObjects: true }) as string[]);

  const dayNames = (t('common.dayNames', { returnObjects: true }) as string[]);

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      {/* Bouton de déclenchement */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={`w-full flex items-center justify-between px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-600'
        }`}
      >
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-400" />
          <span className="truncate">
            {selectedDate ? formatDate(selectedDate) : placeholder}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {selectedDate && (
            <button
              onClick={handleClear}
              className="p-1 hover:bg-gray-600 rounded transition-colors"
            >
              <X className="w-3 h-3 text-gray-400 hover:text-white" />
            </button>
          )}
          <ChevronDown 
            className={`w-4 h-4 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`} 
          />
        </div>
      </button>

      {/* Calendrier dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: position === 'top' ? 10 : -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: position === 'top' ? 10 : -10, scale: 0.95 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className={`absolute ${
              position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
            } left-0 right-0 z-[99999] bg-gray-800 border border-gray-600 rounded-lg shadow-xl overflow-hidden w-full min-w-[280px] sm:min-w-[320px]`}
            style={{ zIndex: 99999 }}
          >
            {/* En-tête du calendrier */}
            <div className="flex items-center justify-between p-3 border-b border-gray-600">
              <button
                onClick={() => navigateMonth('prev')}
                className="p-1 hover:bg-gray-700 rounded transition-colors"
              >
                <ChevronDown className="w-4 h-4 rotate-90 text-gray-400" />
              </button>
              <h3 className="text-white font-medium">
                {monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}
              </h3>
              <button
                onClick={() => navigateMonth('next')}
                className="p-1 hover:bg-gray-700 rounded transition-colors"
              >
                <ChevronDown className="w-4 h-4 -rotate-90 text-gray-400" />
              </button>
            </div>

            {/* Jours de la semaine */}
            <div className="grid grid-cols-7 gap-1 p-2">
              {dayNames.map(day => (
                <div key={day} className="text-center text-xs text-gray-400 py-2">
                  {day}
                </div>
              ))}
            </div>

            {/* Grille des jours */}
            <div className="grid grid-cols-7 gap-1 p-2">
              {getDaysArray(currentMonth).map((date, index) => {
                if (!date) {
                  return <div key={index} className="h-8" />;
                }

                const isDisabled = isDateDisabled(date);
                const isSelected = isDateSelected(date);
                const isTodayDate = isToday(date);

                return (
                  <button
                    key={index}
                    onClick={() => !isDisabled && handleDateSelect(date)}
                    disabled={isDisabled}
                    className={`h-8 w-8 text-sm rounded transition-colors ${
                      isDisabled
                        ? 'text-gray-500 cursor-not-allowed'
                        : isSelected
                        ? 'bg-blue-600 text-white'
                        : isTodayDate
                        ? 'bg-blue-600/20 text-blue-300'
                        : 'text-white hover:bg-gray-700'
                    }`}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>

            {/* Boutons d'action */}
            <div className="flex justify-between p-2 border-t border-gray-600">
              <button
                onClick={() => {
                  const today = new Date();
                  if (!isDateDisabled(today)) {
                    handleDateSelect(today);
                  }
                }}
                className="px-3 py-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                {t('common.today')}
              </button>
              <button
                onClick={() => {
                  setSelectedDate(undefined);
                  onChange(undefined);
                  setIsOpen(false);
                }}
                className="px-3 py-1 text-xs text-gray-400 hover:text-white transition-colors"
              >
                {t('common.clear')}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default CustomDatePicker;