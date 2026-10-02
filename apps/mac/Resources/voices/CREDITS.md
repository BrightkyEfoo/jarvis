# Voix de Jarvis — origine et licences

Les voix françaises masculines de Jarvis sont des **clones PocketTTS** de courts extraits
(10 s) enregistrés par des personnes qui ont **donné leur voix pour le clonage**. Les conditions
de PocketTTS interdisent de cloner une voix sans consentement explicite : seuls des extraits de
ce type sont acceptés ici.

| Fichier | Voix dans Jarvis | Source | Licence |
|---|---|---|---|
| `fr-fabien.wav` | Fabien | Kyutai, `unmute-prod-website/fabieng-enhanced-v2.wav` (enregistrement de l'équipe Kyutai) | CC0 |
| `fr-theo.wav` | Théo | Kyutai Unmute Voice Donation Project, `voice-donations/2181_enhanced.wav` (le donneur y dit son accord pour le clonage) | CC0 |
| `fr-samuel.wav` | Samuel | Kyutai Unmute Voice Donation Project, `voice-donations/SSA150803_enhanced.wav` | CC0 |
| `fr-erick.wav` | Erick | Kyutai Unmute Voice Donation Project, `voice-donations/Erick_enhanced.wav` | CC0 |

Dépôt d'origine : https://huggingface.co/kyutai/tts-voices. Les versions `_enhanced` ont été
nettoyées par Kyutai avec ai-coustics.

> Volhejn, V. (2025). *Unmute Voice Donation Project*. https://unmute.sh/voice-donation

Les voix anglaises (Charles, Javert, Michael, Peter, Jean, Paul, George, Alba) et la voix
française Estelle sont les voix fournies avec PocketTTS.

## Modèles

| Modèle | Usage | Licence |
|---|---|---|
| Kyutai Pocket TTS (conversion CoreML de FluidInference) | Synthèse vocale FR et EN | CC BY 4.0 (poids) |
| NVIDIA Parakeet TDT 0.6B v3 (conversion CoreML de FluidInference) | Reconnaissance vocale FR et EN | CC BY 4.0 |
| FluidAudio 0.17.5 | Exécution CoreML en Swift | Apache 2.0 |

Interdit par les conditions de Pocket TTS, et donc par Jarvis : se faire passer pour quelqu'un,
cloner une voix sans consentement, présenter un audio généré comme un enregistrement réel.
