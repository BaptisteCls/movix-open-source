import React from 'react';

const DetailsSkeleton: React.FC = () => {
  return (
    <div className="container mx-auto px-4 py-8 animate-pulse">
      {/* Hero section skeleton */}
      <div className="flex flex-col md:flex-row gap-8">
        {/* Poster skeleton */}
        <div className="w-[300px] h-[450px] bg-gray-700 rounded-lg flex-shrink-0"></div>
        
        {/* Content skeleton */}
        <div className="flex-1">
          {/* Title skeleton */}
          <div className="h-8 bg-gray-700 rounded w-3/4 mb-4"></div>
          
          {/* Meta info skeleton */}
          <div className="flex gap-4 mb-6">
            <div className="h-4 bg-gray-700 rounded w-20"></div>
            <div className="h-4 bg-gray-700 rounded w-20"></div>
            <div className="h-4 bg-gray-700 rounded w-20"></div>
          </div>
          
          {/* Overview skeleton */}
          <div className="space-y-2 mb-6">
            <div className="h-4 bg-gray-700 rounded w-full"></div>
            <div className="h-4 bg-gray-700 rounded w-full"></div>
            <div className="h-4 bg-gray-700 rounded w-3/4"></div>
          </div>
          
          {/* Buttons skeleton */}
          <div className="flex gap-4">
            <div className="h-10 bg-gray-700 rounded w-32"></div>
            <div className="h-10 bg-gray-700 rounded w-32"></div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DetailsSkeleton;
