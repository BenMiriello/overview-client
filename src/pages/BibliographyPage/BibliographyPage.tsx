import citations from './citations.yaml';
import { NavigationIcons } from '../../components/Navigation';
import './BibliographyPage.css';

interface ICitation {
  id: number;
  title: string;
  author: string;
  year: number;
  publisher: string;
  access_date: string;
  url: string;
  summary: string;
}

const Citation = (citation: ICitation) => (
  <li key={citation.id}>
    <a href={citation.url} target="_blank" rel="noopener noreferrer">
      {citation.title}
    </a>
    {citation.summary && <p>{citation.summary}</p>}
  </li>
);

const BibliographyPage = () => (
  <div className="bibliography-page">
    <h1>Links & Sources</h1>
    {/* <p className="intro">
      Resources and references used in the development of our lightning simulation algorithm.
    </p> */}

    <div className="bibliography-content">
      <ul>
        {/* <h2>Modeling and Scientific Resources</h2> */}
        <ul>{citations.sources.map(Citation)}</ul>
        {/* <h2>Further Reading</h2> */}
        {/* <ul>{citations.further_reading.map(Citation)}</ul> */}
      </ul>
    </div>

    <NavigationIcons currentPage="bibliography" />
  </div>
);

export default BibliographyPage;
