import { Link } from 'react-router-dom';
import { Globe, Zap, NotebookTabs } from 'lucide-react';
import './NavigationIcons.css';

interface NavigationIconsProps {
  currentPage: 'globe' | 'lightning' | 'bibliography';
}

const NavigationIcons: React.FC<NavigationIconsProps> = ({ currentPage }) => {
  return (
    <>
      {currentPage !== 'globe' && (
        <Link
          to="/"
          className="nav-icon globe-icon"
          aria-label="Go to Globe view"
        >
          <Globe size={24} />
        </Link>
      )}

      {currentPage !== 'lightning' && (
        <Link
          to="/lightning"
          className="nav-icon lightning-icon"
          aria-label="Go to Lightning showcase"
        >
          <Zap size={24} />
        </Link>
      )}

      {currentPage !== 'bibliography' && (
        <Link
          to="/bibliography"
          className="nav-icon bibliography-icon"
          aria-label="View bibliography"
        >
          <NotebookTabs size={24} />
        </Link>
      )}
    </>
  );
};

export default NavigationIcons;
