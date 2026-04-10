import { Link } from 'react-router-dom';
import { Globe, Zap, NotebookTabs } from 'lucide-react';
import './NavigationIcons.css';

interface NavigationIconsProps {
  currentPage: 'globe' | 'lightning' | 'bibliography';
}

const NavigationIcons: React.FC<NavigationIconsProps> = ({ currentPage }) => {
  return (
    <div className="nav-icons-group">
      <Link
        to="/"
        className={`nav-icon${currentPage === 'globe' ? ' active' : ''}`}
        aria-label="Go to Globe view"
      >
        <Globe size={20} />
      </Link>

      <Link
        to="/lightning"
        className={`nav-icon${currentPage === 'lightning' ? ' active' : ''}`}
        aria-label="Go to Lightning showcase"
      >
        <Zap size={20} />
      </Link>

      <Link
        to="/bibliography"
        className={`nav-icon${currentPage === 'bibliography' ? ' active' : ''}`}
        aria-label="View bibliography"
      >
        <NotebookTabs size={20} />
      </Link>
    </div>
  );
};

export default NavigationIcons;
