import styled from 'styled-components';
import { t } from '../i18n';
import { currentApp, DOWNLOADS, SOURCE_URL, type Downloads } from '../library/downloads';
import { NARROW } from '../styles/GlobalStyle';
import { Button, Muted, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

const Scroll = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0 -20px;
  padding: 0 20px;

  h3 {
    margin: 24px 0 8px;
    font-size: 1rem;
  }

  p {
    margin: 0 0 8px;
    line-height: 1.5;
  }
`;

const Hero = styled.div`
  display: flex;
  gap: 16px;
  align-items: center;
  margin: 8px 0 16px;

  img {
    width: 72px;
    height: 72px;
    border-radius: 18px;
  }

  strong {
    display: block;
    font-size: 1.6rem;
    letter-spacing: 0.02em;
  }
`;

const Features = styled.ul`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 24px;
  margin: 0;
  padding: 0;
  list-style: none;

  ${NARROW} {
    grid-template-columns: minmax(0, 1fr);
  }

  strong {
    display: block;
  }
`;

const Apps = styled.ul`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;

  ${NARROW} {
    grid-template-columns: minmax(0, 1fr);
  }

  li {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  a {
    align-self: flex-start;
    text-decoration: none;
  }
`;

const FEATURES = ['import', 'read', 'convert', 'send', 'sync', 'search'] as const;
const APPS = ['desktop', 'android', 'ios'] as const;

/**
 * About nexlibris: what it is, where to get its apps, and its source. Opened from the name in the top bar, and on
 * its own when the library is new (`firstRun`), with Get started.
 */
export function AboutDialog({
  onClose,
  firstRun = false,
  onGetStarted,
  downloads = DOWNLOADS,
  app = currentApp(),
}: {
  onClose(): void;
  /** The library is new and untouched: welcomes rather than describes, and offers Get started. */
  firstRun?: boolean;
  onGetStarted?(): void;
  /** For stories: where the apps are, and which one this is. */
  downloads?: Downloads;
  app?: keyof Downloads;
}) {
  return (
    <Modal title={t('about.title')} wide onClose={onClose}>
      <Scroll>
        <Hero>
          <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" />
          <div>
            <strong>{t('app.name')}</strong>
            <Muted>{t('about.tagline')}</Muted>
          </div>
        </Hero>
        <p>{firstRun ? t('about.welcome') : t('about.intro')}</p>

        <h3>{t('about.whatItDoes')}</h3>
        <Features>
          {FEATURES.map((feature) => (
            <li key={feature}>
              <strong>{t(`about.features.${feature}.title`)}</strong>
              <Muted>{t(`about.features.${feature}.text`)}</Muted>
            </li>
          ))}
        </Features>

        <h3>{t('about.apps')}</h3>
        <p>
          <Muted>{t('about.appsIntro')}</Muted>
        </p>
        <Apps>
          {APPS.map((kind) => {
            const url = downloads[kind];
            return (
              <li key={kind}>
                <strong>{t(`about.app.${kind}.name`)}</strong>
                <Muted>{t(`about.app.${kind}.platforms`)}</Muted>
                <Spacer />
                {app === kind ? (
                  <Muted>{t('about.thisOne')}</Muted>
                ) : url ? (
                  <Button as="a" $variant="secondary" $size="small" href={url} target="_blank" rel="noreferrer">
                    {t(`about.app.${kind}.download`)}
                  </Button>
                ) : (
                  <Muted>{t(`about.app.${kind}.unavailable`)}</Muted>
                )}
              </li>
            );
          })}
        </Apps>

        <h3>{t('about.source')}</h3>
        <p>
          <Muted>
            {t('about.sourceText')}{' '}
            <a href={SOURCE_URL} target="_blank" rel="noreferrer">
              {SOURCE_URL.replace(/^https:\/\//, '')}
            </a>
          </Muted>
        </p>
      </Scroll>
      <ModalFooter>
        <Spacer />
        <Button $variant={firstRun && onGetStarted ? 'secondary' : 'primary'} onClick={onClose}>
          {t('common.close')}
        </Button>
        {firstRun && onGetStarted && <Button onClick={onGetStarted}>{t('about.getStarted')}</Button>}
      </ModalFooter>
    </Modal>
  );
}
