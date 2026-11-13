# Poli Clima

Aplicación que publica el clima del campus del Politécnico Grancolombiano a partir de su estación meteorológica, lo traduce a recomendaciones prácticas para la comunidad y guarda un histórico para análisis.

## Language

### La estación y sus datos

**Estación**:
La estación meteorológica automática del campus (`POLITECNICO_CONSOLA1`): sensores más consola. Es la única fuente de lo que _se mide_.
_Avoid_: sensor (es una parte), sitio, equipo

**WeatherLink**:
La nube del fabricante (Davis) que recibe las lecturas de la estación y las entrega junto con el pronóstico. Es un tercero: puede fallar sin que la estación falle.
_Avoid_: API, proveedor

**Lectura**:
Las condiciones medidas por la estación en un instante: temperatura, sensación, humedad, viento, ráfaga, dirección, presión y lluvia.
_Avoid_: dato, medición, registro, muestra

**Hora de la lectura**:
El instante en que la estación midió, según ella misma. Es distinta de la hora en que Poli Clima la consultó o la guardó.
_Avoid_: timestamp, hora de actualización

**Estación sin reportar**:
Situación en la que la última lectura tiene más de 30 minutos de antigüedad. La página debe advertirlo en lugar de mostrar la lectura como actual.
_Avoid_: caída, offline, dato viejo

**Lectura guardada**:
La última lectura conocida que la página muestra cuando no puede consultar nada. Siempre se rotula como guardada, nunca como actual.
_Avoid_: caché, respaldo

### El pronóstico

**Pronóstico**:
Estimación del día que entrega WeatherLink. No se mide ni se calcula en Poli Clima: se muestra y se archiva tal cual llega.
_Avoid_: predicción, previsión

**Tramo**:
Cada una de las cuatro partes del día en que se divide el pronóstico: mañana (6 a. m.–12 p. m.), tarde (12–6 p. m.), noche (6–10 p. m.) y madrugada (10 p. m.–6 a. m.).
_Avoid_: franja, período, turno

**Tramo actual**:
El tramo que contiene la hora de Bogotá en el momento de mirar.

**Versión del pronóstico**:
Una combinación distinta de temperatura, probabilidad de lluvia y descripción para una fecha y un tramo. Cuando WeatherLink cambia cualquiera de las tres, nace una versión nueva y la anterior se conserva.
_Avoid_: actualización del pronóstico

### Lo que se le dice a la comunidad

**Recomendación**:
Consejo práctico derivado de la lectura y del pronóstico de los tramos que quedan: paraguas, chaqueta, viento o mejor momento.
_Avoid_: alerta, sugerencia

**Mejor momento**:
El tramo restante del día, sin contar la madrugada, con menor probabilidad de lluvia; si hay empate, el más cálido.
_Avoid_: ventana, hora ideal

### Operación e histórico

**Recolector**:
El proceso del servidor que consulta la estación a intervalos fijos y guarda cada lectura nueva, aunque nadie tenga la página abierta.
_Avoid_: scraper, cron, tarea programada

**Histórico**:
Todas las lecturas y versiones del pronóstico guardadas desde el día en que se activó el recolector. No incluye nada anterior: la estación solo entrega el momento actual. Solo lo ven el analista de datos y el administrador técnico.
_Avoid_: archivo, log, registro

**Día (de Bogotá)**:
El día de calendario en hora de Colombia (UTC−5, sin horario de verano). Los rangos que se piden al histórico se interpretan así.
_Avoid_: día UTC, día del servidor

**Sesión**:
El acceso que el analista o el administrador abre desde la página con su usuario y contraseña, y que **Cerrar sesión** destruye en el servidor. Caduca sola a las 8 horas.
_Avoid_: login, cuenta

### Personas

**Comunidad**:
Estudiantes, docentes, administrativos y visitantes que consultan la página. Solo leen el clima y no necesitan clave.
_Avoid_: usuarios finales, clientes

**Administrador técnico**:
Quien despliega y opera el servidor y respalda la base. Es, con el analista, quien puede ver el histórico, y el único que ve la salud del servicio.

**Analista de datos**:
Quien se identifica para descargar o consultar el histórico y estudiarlo. No ve la salud del servicio.

**Responsable de la estación**:
Quien mantiene los sensores, la consola, la conexión y la cuenta de WeatherLink.
