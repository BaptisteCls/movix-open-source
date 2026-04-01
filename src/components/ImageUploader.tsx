import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, X, Camera } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface ImageUploaderProps {
  onImageUpload: (url: string) => void;
  currentImage?: string;
}

const ImageUploader: React.FC<ImageUploaderProps> = ({ onImageUpload, currentImage }) => {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(currentImage || null);
  const [isHovered, setIsHovered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      await handleImageUpload(file);
    }
  }, []);

  const handleImageUpload = async (file: File) => {
    try {
      setIsLoading(true);

      // Créer une prévisualisation immédiate
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        setPreviewImage(result);
        
        // Compression de l'image si nécessaire
        const img = new Image();
        img.src = result;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          // Définir la taille maximale
          const MAX_WIDTH = 800;
          const MAX_HEIGHT = 800;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height *= MAX_WIDTH / width;
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width *= MAX_HEIGHT / height;
              height = MAX_HEIGHT;
            }
          }

          canvas.width = width;
          canvas.height = height;
          ctx?.drawImage(img, 0, 0, width, height);

          // Convertir en base64 avec compression
          const compressedImage = canvas.toDataURL('image/jpeg', 0.8);
          onImageUpload(compressedImage);
          setIsLoading(false);
        };
      };
      reader.readAsDataURL(file);

    } catch (error) {
      console.error('Erreur lors de l\'upload:', error);
      setIsLoading(false);
    }
  };

  return (
    <motion.div
      className="relative w-full"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div
        className={`relative w-full h-64 border-2 border-dashed rounded-xl transition-all duration-300 ${
          isDragging 
            ? 'border-red-500 bg-red-500/10' 
            : 'border-gray-600 hover:border-red-500'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <AnimatePresence>
          {previewImage ? (
            <motion.div 
              className="relative w-full h-full group"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <img
                src={previewImage}
                alt="Preview"
                className="w-full h-full object-cover rounded-lg"
              />
              <motion.div 
                className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: isHovered ? 1 : 0 }}
              >
                <label className="p-2 bg-red-600 rounded-full text-white hover:bg-red-700 transition-colors cursor-pointer">
                  <Camera className="w-5 h-5" />
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImageUpload(file);
                    }}
                  />
                </label>
                <button
                  onClick={() => {
                    setPreviewImage(null);
                  }}
                  className="p-2 bg-gray-600 rounded-full text-white hover:bg-gray-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </motion.div>
            </motion.div>
          ) : (
            <motion.div 
              className="absolute inset-0 flex flex-col items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <Upload className="w-12 h-12 text-gray-400 mb-4" />
              <p className="text-gray-400 text-center px-4">
                {t('admin.dragImageHereOr')}{' '}
                <label className="text-red-500 cursor-pointer hover:text-red-600">
                  {t('admin.browse')}
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImageUpload(file);
                    }}
                  />
                </label>
              </p>
              <p className="text-sm text-gray-500 mt-2">
                {t('admin.recommendedFormat')}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {isLoading && (
        <motion.div 
          className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin"></div>
        </motion.div>
      )}
    </motion.div>
  );
};

export default ImageUploader; 