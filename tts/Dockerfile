FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install --no-cache-dir numpy edge-tts

# Модель Silero TTS v4 для русского языка (~40 МБ), кладём в образ на этапе сборки
ADD https://models.silero.ai/models/tts/ru/v4_ru.pt /app/v4_ru.pt
RUN chmod 644 /app/v4_ru.pt

COPY server.py .

ENV PORT=5002
EXPOSE 5002

CMD ["python", "server.py"]
