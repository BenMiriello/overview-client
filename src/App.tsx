import { Routes, Route } from 'react-router-dom';
import './App.css';
import { GlobePage, ShowcasePage, BibliographyPage } from './pages';

function App() {
  return (
    <div className="App">
      <Routes>
        <Route path="/" element={<GlobePage />} />
        <Route path="/lightning" element={<ShowcasePage/>} />
        <Route path="/bibliography" element={<BibliographyPage />} />
      </Routes>
    </div>
  );
}

export default App;
