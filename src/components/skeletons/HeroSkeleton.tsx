import React from 'react';

const HeroSkeleton: React.FC = () => {
  return (
    <div className="relative w-full h-[600px] animate-pulse">
      {/* Background skeleton */}
      <div className="absolute inset-0 bg-gray-700"></div>
      
      {/* Content skeleton */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 to-transparent">
        <div className="container mx-auto h-full flex items-center">
          <div className="max-w-2xl space-y-6 p-8">
            {/* Title skeleton */}
            <div className="h-12 bg-gray-600 rounded-lg w-3/4"></div>
            
            {/* Rating and date skeleton */}
            <div className="flex space-x-6">
              <div className="h-6 bg-gray-600 rounded w-24"></div>
              <div className="h-6 bg-gray-600 rounded w-32"></div>
            </div>
            
            {/* Overview skeleton */}
            <div className="space-y-3">
              <div className="h-4 bg-gray-600 rounded w-full"></div>
              <div className="h-4 bg-gray-600 rounded w-full"></div>
              <div className="h-4 bg-gray-600 rounded w-3/4"></div>
            </div>
            
            {/* Buttons skeleton */}
            <div className="flex space-x-4 pt-4">
              <div className="h-12 bg-gray-600 rounded-lg w-36"></div>
              <div className="h-12 bg-gray-600 rounded-lg w-36"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeroSkeleton;
