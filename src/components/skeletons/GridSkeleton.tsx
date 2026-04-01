import React from 'react';

const GridSkeleton: React.FC = () => {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 animate-pulse">
      {[...Array(20)].map((_, index) => (
        <div key={index} className="flex flex-col gap-2">
          {/* Poster skeleton */}
          <div className="aspect-[2/3] bg-gray-700 rounded-lg"></div>
          
          {/* Title skeleton */}
          <div className="h-4 bg-gray-700 rounded w-3/4"></div>
          
          {/* Year and rating skeleton - Retirer cette section */}
          <div className="flex gap-2 hidden">
            <div className="h-3 bg-gray-700 rounded w-16"></div>
            <div className="h-3 bg-gray-700 rounded w-12"></div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default GridSkeleton;
